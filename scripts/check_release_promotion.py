"""Exercise real immutable promotion in an owned, loopback-only OCI registry.

The synthetic images require no emulator and are never executed. The fixture
contains both platform configs and SPDX/provenance attestation payloads; the
contract checks registry transport and whole-index preservation, not the app.
"""

import hashlib
import json
import subprocess
import time
from urllib.error import HTTPError
from urllib.parse import urljoin
from urllib.request import ProxyHandler, Request, build_opener
import uuid

from release_image import inspect_candidate, promote


REGISTRY = 'registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373'
OCI = 'application/vnd.oci.image.'
REVISION = '1' * 40
HTTP = build_opener(ProxyHandler({}))


def docker(*args):
    result = subprocess.run(['docker', *args], capture_output=True,
                            text=True, timeout=180)
    if result.returncode:
        raise RuntimeError(f'Docker command failed: {result.stderr.strip()}')
    return result.stdout.strip()


def request(url, method='GET', data=None, content_type='application/json'):
    return HTTP.open(Request(url, data=data, method=method,
                             headers={'Content-Type': content_type}), timeout=10)


def encode(value):
    return json.dumps(value, separators=(',', ':')).encode()


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def seed(base):
    def blob(value, media_type):
        data = encode(value)
        with request(base + '/blobs/uploads/', 'POST', b'') as response:
            location = urljoin(base, response.headers['Location'])
        separator = '&' if '?' in location else '?'
        with request(location + separator + 'digest=' + digest(data), 'PUT',
                     data, 'application/octet-stream'):
            pass
        return {'mediaType': media_type, 'size': len(data), 'digest': digest(data)}

    def manifest(config, layers):
        value = {'schemaVersion': 2, 'mediaType': OCI + 'manifest.v1+json',
                 'config': config, 'layers': layers}
        data = encode(value)
        with request(base + '/manifests/' + digest(data), 'PUT', data, value['mediaType']):
            pass
        return {'mediaType': value['mediaType'], 'size': len(data), 'digest': digest(data)}

    descriptors = []
    for arch in ('amd64', 'arm64'):
        config = blob({'architecture': arch, 'os': 'linux',
                       'config': {'Labels': {'org.opencontainers.image.revision': REVISION}},
                       'rootfs': {'type': 'layers', 'diff_ids': []}}, OCI + 'config.v1+json')
        runtime = manifest(config, [])
        runtime['platform'] = {'os': 'linux', 'architecture': arch}
        descriptors.append(runtime)
        layers = []
        for predicate_type, predicate in (
            ('https://spdx.dev/Document', {'spdxVersion': 'SPDX-2.3'}),
            ('https://slsa.dev/provenance/v0.2', {'buildType': 'webssh-promotion-contract'}),
        ):
            layer = blob({'_type': 'https://in-toto.io/Statement/v0.1',
                          'subject': [{'name': arch, 'digest': {'sha256': runtime['digest'][7:]}}],
                          'predicateType': predicate_type, 'predicate': predicate},
                         'application/vnd.in-toto+json')
            layer['annotations'] = {'in-toto.io/predicate-type': predicate_type}
            layers.append(layer)
        config = blob({'architecture': 'unknown', 'os': 'unknown', 'config': {},
                       'rootfs': {'type': 'layers', 'diff_ids': []}}, OCI + 'config.v1+json')
        attestation = manifest(config, layers)
        attestation['platform'] = {'os': 'unknown', 'architecture': 'unknown'}
        attestation['annotations'] = {'vnd.docker.reference.type': 'attestation-manifest',
                                      'vnd.docker.reference.digest': runtime['digest']}
        descriptors.append(attestation)
    index = encode({'schemaVersion': 2, 'mediaType': OCI + 'index.v1+json',
                    'manifests': descriptors})
    with request(base + '/manifests/' + digest(index), 'PUT', index, OCI + 'index.v1+json'):
        pass
    return index


def main():
    owner = uuid.uuid4().hex
    name = 'webssh-promotion-' + owner
    container = None
    try:
        # Create before start so a start failure still leaves a known owned ID.
        container = docker('create', '--name', name, '--label', 'webssh.promotion=' + owner,
                           '--publish', '127.0.0.1::5000', REGISTRY)
        docker('start', container)
        binding = docker('port', container, '5000/tcp').splitlines()[0]
        base = 'http://' + binding
        for attempt in range(60):
            try:
                with request(base + '/v2/'):
                    break
            except OSError:
                if attempt == 59:
                    raise
                time.sleep(0.5)
        image = binding + '/contract/image'
        api = base + '/v2/contract/image'
        original = seed(api)
        candidate = digest(original)
        try:
            with request(api + '/tags/list') as response:
                if json.load(response).get('tags'):
                    raise AssertionError('Candidate must be digest-only')
        except HTTPError as error:
            # Distribution returns NAME_UNKNOWN before the first tag exists.
            if error.code != 404:
                raise
        inspect_candidate(image, candidate, REVISION)
        for suffixes in (('main', 'latest'), ('2.4.0', '2.4', 'latest')):
            tags = [image + ':' + tag for tag in suffixes]
            evidence = promote(image, candidate, REVISION, tags)
            for tag in suffixes:
                req = Request(api + '/manifests/' + tag,
                              headers={'Accept': OCI + 'index.v1+json'})
                with HTTP.open(req, timeout=10) as response:
                    if response.read() != original:
                        raise AssertionError('Promotion changed the full index or attestations')
            print(json.dumps(evidence, indent=2))
        try:
            promote(image, candidate, '2' * 40, [image + ':rejected'])
        except ValueError:
            pass
        else:
            raise AssertionError('Wrong source revision was accepted')
        with request(api + '/tags/list') as response:
            if 'rejected' in json.load(response)['tags']:
                raise AssertionError('Rejected candidate wrote a tag')
        print('Immutable promotion contract passed, including attestations and rejected revision')
    finally:
        if container:
            actual = docker('inspect', '--format', '{{ index .Config.Labels "webssh.promotion" }}', container)
            if actual != owner:
                raise RuntimeError('Refusing to remove a registry with unexpected ownership')
            docker('rm', '--force', '--volumes', container)


if __name__ == '__main__':
    main()
