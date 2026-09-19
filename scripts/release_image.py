"""Inspect and promote one immutable multi-platform release candidate."""

import argparse
import json
from pathlib import Path
import re
import subprocess


DIGEST = re.compile(r'sha256:[0-9a-f]{64}')
REVISION = re.compile(r'[0-9a-f]{40}')
REPOSITORY = re.compile(r'[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+')
TAG = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}')
PLATFORMS = frozenset({'linux/amd64', 'linux/arm64'})
INDEX_TYPES = frozenset({
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
})


def validate_index(index):
    """Require both runtime platforms and their retained attestations."""
    if index.get('schemaVersion') != 2 or index.get('mediaType') not in INDEX_TYPES:
        raise ValueError('Candidate must be a multi-platform image index')
    platforms = {}
    attestations = set()
    for descriptor in index.get('manifests', []):
        digest = descriptor.get('digest', '')
        if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
            raise ValueError('Invalid child manifest digest')
        platform = descriptor.get('platform', {})
        name = f"{platform.get('os')}/{platform.get('architecture')}"
        if name in PLATFORMS:
            if name in platforms:
                raise ValueError('Duplicate runtime platform')
            platforms[name] = digest
        elif name == 'unknown/unknown':
            annotations = descriptor.get('annotations', {})
            if annotations.get('vnd.docker.reference.type') != 'attestation-manifest':
                raise ValueError('Unknown descriptor is not an attestation')
            attestations.add(annotations.get('vnd.docker.reference.digest'))
        else:
            raise ValueError('Unexpected runtime platform')
    if set(platforms) != PLATFORMS:
        raise ValueError('Both AMD64 and ARM64 are required')
    if set(platforms.values()) != attestations:
        raise ValueError('Each runtime platform must retain its attestation')
    return platforms


def _identity(image, digest, revision):
    if not REPOSITORY.fullmatch(image) or '..' in image or '//' in image:
        raise ValueError('Invalid image repository')
    if not DIGEST.fullmatch(digest):
        raise ValueError('Invalid candidate digest')
    if not REVISION.fullmatch(revision):
        raise ValueError('Invalid source revision')


def _docker(arguments, runner):
    return runner(
        ['docker', 'buildx', 'imagetools', *arguments],
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def inspect_candidate(image, digest, revision, *, runner=subprocess.run):
    """Read registry identity and source labels without writing any tags."""
    _identity(image, digest, revision)
    reference = f'{image}@{digest}'
    actual = _docker(['inspect', '--format', '{{.Manifest.Digest}}', reference], runner)
    if actual != digest:
        raise ValueError('Candidate digest does not match registry identity')
    index = json.loads(_docker(['inspect', '--raw', reference], runner))
    platforms = validate_index(index)
    for platform, child in platforms.items():
        config = json.loads(_docker([
            'inspect', '--format', '{{json .Image}}', f'{image}@{child}',
        ], runner))
        if f"{config.get('os')}/{config.get('architecture')}" != platform:
            raise ValueError('Child config does not match its declared platform')
        labels = config.get('config', {}).get('Labels', {})
        if labels.get('org.opencontainers.image.revision') != revision:
            raise ValueError('Candidate revision does not match the tested commit')
    return {
        'repository': image, 'revision': revision, 'digest': digest,
        'immutable_ref': reference, 'platforms': platforms,
    }


def promote(image, digest, revision, tags, *, require_current_main=False,
            runner=subprocess.run):
    """Copy the complete checked index, then verify every destination tag."""
    _identity(image, digest, revision)
    if not tags or len(tags) > 16 or len(set(tags)) != len(tags):
        raise ValueError('A bounded, nonempty list of unique tags is required')
    prefix = image + ':'
    for tag in tags:
        if not tag.startswith(prefix) or not TAG.fullmatch(tag[len(prefix):]):
            raise ValueError('Release tags must stay in the candidate repository')
    evidence = inspect_candidate(image, digest, revision, runner=runner)
    arguments = ['create']
    for tag in tags:
        arguments.extend(['--tag', tag])
    # A single existing index is copied verbatim, including attestations.
    # Adding annotations, platform filters or child sources would change it.
    arguments.append(evidence['immutable_ref'])
    if require_current_main:
        # Test jobs run in parallel, so queue arrival need not match push order.
        # Recheck inside the publisher lock immediately before changing tags.
        remote = runner(
            ['git', 'ls-remote', '--exit-code', 'origin', 'refs/heads/main'],
            check=True, capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        if remote != revision + '\trefs/heads/main':
            raise ValueError('Source revision is no longer the current main commit')
    _docker(arguments, runner)
    for tag in tags:
        actual = _docker(['inspect', '--format', '{{.Manifest.Digest}}', tag], runner)
        if actual != digest:
            raise ValueError(f'Published tag has an unexpected digest: {tag}')
    return {**evidence, 'tags': tags}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('inspect', 'promote'))
    parser.add_argument('--image', required=True)
    parser.add_argument('--digest', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--tags-file', type=Path)
    parser.add_argument('--require-current-main', action='store_true',
                        help='Reject promotion if origin/main advanced during testing')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.mode == 'promote':
        if args.tags_file is None:
            parser.error('promote requires --tags-file')
        tags = args.tags_file.read_text(encoding='utf-8').splitlines()
        evidence = promote(args.image, args.digest, args.revision, tags,
                           require_current_main=args.require_current_main)
    else:
        evidence = inspect_candidate(args.image, args.digest, args.revision)
    args.output.write_text(json.dumps(evidence, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
