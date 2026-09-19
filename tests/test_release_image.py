"""Release promotion must preserve the tested, scanned image identity."""

from copy import deepcopy
import json
from types import SimpleNamespace

import pytest

from scripts.release_image import inspect_candidate, promote, validate_index


IMAGE = 'ghcr.io/bifrost0x/webssh'
REVISION = '1' * 40
DIGEST = 'sha256:' + 'a' * 64
AMD64 = 'sha256:' + 'b' * 64
ARM64 = 'sha256:' + 'c' * 64
INDEX = {
    'schemaVersion': 2,
    'mediaType': 'application/vnd.oci.image.index.v1+json',
    'manifests': [
        {'digest': AMD64, 'platform': {'os': 'linux', 'architecture': 'amd64'}},
        {'digest': ARM64, 'platform': {'os': 'linux', 'architecture': 'arm64'}},
        {'digest': 'sha256:' + 'd' * 64,
         'platform': {'os': 'unknown', 'architecture': 'unknown'},
         'annotations': {'vnd.docker.reference.type': 'attestation-manifest',
                         'vnd.docker.reference.digest': AMD64}},
        {'digest': 'sha256:' + 'e' * 64,
         'platform': {'os': 'unknown', 'architecture': 'unknown'},
         'annotations': {'vnd.docker.reference.type': 'attestation-manifest',
                         'vnd.docker.reference.digest': ARM64}},
    ],
}


class Registry:
    def __init__(self):
        self.calls = []
        self.index = deepcopy(INDEX)
        self.revisions = {'amd64': REVISION, 'arm64': REVISION}
        self.published_digest = DIGEST
        self.main_revision = REVISION

    def __call__(self, args, **kwargs):
        self.calls.append(args)
        assert kwargs['check'] is True
        assert kwargs.get('shell', False) is False
        if args[:3] == ['git', 'ls-remote', '--exit-code']:
            assert args[3:] == ['origin', 'refs/heads/main']
            return SimpleNamespace(stdout=self.main_revision + '\trefs/heads/main\n')
        assert args[:3] == ['docker', 'buildx', 'imagetools']
        if args[3] == 'create':
            return SimpleNamespace(stdout='')
        reference = args[-1]
        if '--raw' in args:
            return SimpleNamespace(stdout=json.dumps(self.index))
        template = args[args.index('--format') + 1]
        if template == '{{.Manifest.Digest}}':
            digest = DIGEST if '@' in reference else self.published_digest
            return SimpleNamespace(stdout=digest + '\n')
        assert template == '{{json .Image}}'
        arch = 'amd64' if reference.endswith(AMD64) else 'arm64'
        return SimpleNamespace(stdout=json.dumps({
            'architecture': arch, 'os': 'linux',
            'config': {'Labels': {'org.opencontainers.image.revision': self.revisions[arch]}},
        }))


def test_promotion_copies_one_complete_index_without_rebuilding():
    registry = Registry()
    tags = [IMAGE + ':2.4.0', IMAGE + ':2.4', IMAGE + ':latest']
    evidence = promote(IMAGE, DIGEST, REVISION, tags, runner=registry)
    create = [call for call in registry.calls if call[3] == 'create']
    assert len(create) == 1
    assert create[0][-1] == IMAGE + '@' + DIGEST
    assert all(tag in create[0] for tag in tags)
    assert evidence['digest'] == DIGEST
    assert evidence['revision'] == REVISION
    assert evidence['platforms'] == {'linux/amd64': AMD64, 'linux/arm64': ARM64}
    assert evidence['tags'] == tags
    assert all(call[:3] == ['docker', 'buildx', 'imagetools'] for call in registry.calls)


@pytest.mark.parametrize('change', ['missing-arm', 'duplicate-amd', 'unexpected-os', 'missing-attestation', 'bad-digest'])
def test_invalid_candidate_never_reaches_tag_publication(change):
    registry = Registry()
    if change == 'missing-arm':
        registry.index['manifests'].pop(1)
    elif change == 'duplicate-amd':
        registry.index['manifests'].append(deepcopy(INDEX['manifests'][0]))
    elif change == 'unexpected-os':
        registry.index['manifests'][1]['platform']['os'] = 'windows'
    elif change == 'missing-attestation':
        registry.index['manifests'].pop()
    else:
        registry.index['manifests'][0]['digest'] = 'latest'
    with pytest.raises(ValueError):
        promote(IMAGE, DIGEST, REVISION, [IMAGE + ':latest'], runner=registry)
    assert not any(call[3] == 'create' for call in registry.calls)


def test_both_architectures_must_belong_to_the_verified_commit():
    registry = Registry()
    registry.revisions['arm64'] = '2' * 40
    with pytest.raises(ValueError, match='revision'):
        promote(IMAGE, DIGEST, REVISION, [IMAGE + ':latest'], runner=registry)
    assert not any(call[3] == 'create' for call in registry.calls)


@pytest.mark.parametrize('tags', [[], ['another/image:latest'], [IMAGE + ':latest\n--append'], [IMAGE + ':x', IMAGE + ':x']])
def test_tags_are_bounded_and_stay_in_the_candidate_repository(tags):
    registry = Registry()
    with pytest.raises(ValueError):
        promote(IMAGE, DIGEST, REVISION, tags, runner=registry)
    assert registry.calls == []


def test_wrong_published_digest_is_reported_as_failure():
    registry = Registry()
    registry.published_digest = 'sha256:' + 'f' * 64
    with pytest.raises(ValueError, match='digest'):
        promote(IMAGE, DIGEST, REVISION, [IMAGE + ':latest'], runner=registry)


def test_inspection_is_read_only_and_records_both_child_digests():
    registry = Registry()
    evidence = inspect_candidate(IMAGE, DIGEST, REVISION, runner=registry)
    assert evidence['immutable_ref'] == IMAGE + '@' + DIGEST
    assert evidence['platforms'] == validate_index(INDEX)
    assert all(call[3] == 'inspect' for call in registry.calls)


@pytest.mark.parametrize('current_main', ['2' * 40, '', 'invalid'])
def test_stale_or_invalid_main_never_reaches_promotion(current_main):
    registry = Registry()
    registry.main_revision = current_main
    with pytest.raises(ValueError, match='main'):
        promote(IMAGE, DIGEST, REVISION, [IMAGE + ':main'],
                require_current_main=True, runner=registry)
    assert not any(call[0] == 'docker' and call[3] == 'create' for call in registry.calls)


def test_current_main_is_rechecked_after_inspection_before_tag_writes():
    registry = Registry()
    promote(IMAGE, DIGEST, REVISION, [IMAGE + ':main'],
            require_current_main=True, runner=registry)
    guard = next(i for i, call in enumerate(registry.calls) if call[0] == 'git')
    create = next(i for i, call in enumerate(registry.calls) if call[3] == 'create')
    assert guard == create - 1
    assert all(call[3] == 'inspect' for call in registry.calls[:guard])


def test_version_tag_promotion_does_not_require_current_main():
    registry = Registry()
    registry.main_revision = '2' * 40
    promote(IMAGE, DIGEST, REVISION, [IMAGE + ':2.4.0'], runner=registry)
    assert all(call[0] == 'docker' for call in registry.calls)
