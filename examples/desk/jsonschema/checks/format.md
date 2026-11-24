# format: format and content (annotations only)

The desk runs, in work/: `node ../checks/run-suite.js content.json format-date-time.json format-date.json format-duration.json format-email.json format-hostname.json format-idn-email.json format-idn-hostname.json format-ipv4.json format-ipv6.json format-iri-reference.json format-iri.json format-json-pointer.json format-regex.json format-relative-json-pointer.json format-time.json format-unknown.json format-uri-reference.json format-uri-template.json format-uri.json format-uuid.json`

It loads `validate` from work/validate.js and, for every test case in the files below, checks that
`validate(testCase.schema, test.data, testCase.externalSchemas || {})` returns exactly `test.valid`.
The test files are the official JSON Schema Test Suite (2020-12 cases only). You cannot read them; here is what they cover:

- content.json: validation of string-encoded content based on media type; validation of binary string-encoding; validation of binary-encoded media type documents; validation of binary-encoded media type documents with schema
- format-date-time.json: validation of non-string date-time values; date-time annotation
- format-date.json: validation of non-string date values; date format annotation
- format-duration.json: validation of non-string duration values; duration format annotation
- format-email.json: validation of non-string email values; email format annotation
- format-hostname.json: validation of non-string hostname values; hostname format annotation
- format-idn-email.json: validation of non-string idn-email values; idn-email format
- format-idn-hostname.json: validation of non-string idn-hostname values; idn-hostname format annotation
- format-ipv4.json: validation of non-string IP addresses; ipv4 format annotation
- format-ipv6.json: validation of non-string ipv6 values; ipv6 format
- format-iri-reference.json: validation of non-string iri-reference values; iri-reference format annotation
- format-iri.json: validation of non-string iri values; iri format
- format-json-pointer.json: validation of non-string json-pointer values; json-pointer format
- format-regex.json: validation of non-string regex values; regex format
- format-relative-json-pointer.json: validation of non-string relative-json-pointer values; relative-json-pointer format
- format-time.json: validation of non-string time values; time format
- format-unknown.json: unknown format
- format-uri-reference.json: validation of non-string uri-reference values; uri-reference format annotation
- format-uri-template.json: validation of non-string uri-template values; uri-template format annotation
- format-uri.json: validation of non-string uri values; uri format annotation
- format-uuid.json: validation of non-string uuid values; uuid format annotation
