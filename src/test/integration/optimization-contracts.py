"""Packaged HTTP contract check. Install jsonschema/openapi-spec-validator in an isolated venv.
BASE_URL must identify a disposable non-8080 service. No inventory is created by this test.
"""
import json
import os
import time
import uuid
import urllib.request
from urllib.parse import urlparse
from urllib.error import HTTPError
from jsonschema import Draft202012Validator
from openapi_spec_validator import validate

base = os.environ.get('BASE_URL', '')
if not base or urlparse(base).port == 8080:
    raise SystemExit('Use an isolated test service on a port other than 8080')


def call(path, body=None, key=None, expected=200):
    headers = {'Content-Type': 'application/json'}
    if key:
        headers['Idempotency-Key'] = key
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
    try:
        response = urllib.request.urlopen(req)
    except HTTPError as error:
        response = error
    with response:
        assert response.status == expected, (path, response.status, response.read())
        return json.load(response)


passed = 0

def check(name):
    global passed
    passed += 1
    print('PASS', name, flush=True)


spec = call('/api-v2/openapi.json')
validate(spec)
schema = call('/api-v2/optimization-request.schema.json')
Draft202012Validator.check_schema(schema)
example = call('/api-v2/example-request.json')
Draft202012Validator(schema).validate(example)
check('OpenAPI 3.1 and JSON Schema are valid; the published example matches the contract')


def matches(name, document):
    Draft202012Validator({'$ref': '#/components/schemas/' + name, 'components': spec['components']}).validate(document)


matches('Capabilities', call('/api/v2/capabilities'))
matches('ProblemCheck', call('/api/v2/problem-validations', example))
check('real capability and validation responses match the published schemas')
key = str(uuid.uuid4())
job = call('/api/v2/optimization-jobs', example, key, expected=202)
matches('OptimizationJob', job)
identifier = job['id']
for _ in range(100):
    job = call('/api/v2/optimization-jobs/' + identifier)
    matches('OptimizationJob', job)
    if job['state'] in ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']:
        break
    time.sleep(.05)
assert job['state'] == 'SUCCEEDED', job
result = call(job['resultRef'])
matches('OptimizationResult', result)
assert result['fulfillmentStatus'] == 'COMPLETE' and result['meetsRequirement']
assert result['metrics'][0]['value'] == 100
matches('OptimizationRequest', call('/api/v2/optimization-jobs/' + identifier + '/input'))
check('accepted job, polling, archived input and verified result match OpenAPI')
assert call('/api/v2/optimization-jobs', example, key, expected=202)['id'] == identifier
conflict = {**example, 'clientRequestId': 'changed'}
error = call('/api/v2/optimization-jobs', conflict, key, expected=409)
matches('Error', error)
assert error['code'] == 'IDEMPOTENCY_CONFLICT'
check('idempotent repeat and conflict envelope match the public contract')
invalid = {**example, 'unknown': 'cannot ignore'}
assert list(Draft202012Validator(schema).iter_errors(invalid))
matches('Error', call('/api/v2/problem-validations', invalid, expected=400))
assert call('/api/cutting/tasks') == []
assert call('/api/rolls') == []
assert call('/api/remnants') == []
check('unknown input is rejected and calculation writes no inventory, roll or business task')
print(f'Executed {passed}; passed {passed}; failed 0')
