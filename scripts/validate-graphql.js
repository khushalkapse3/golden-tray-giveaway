#!/usr/bin/env node
'use strict';

// Dev check: validates every document in src/shopify/documents.js against a Shopify Admin
// schema (SDL, optionally gzipped). Needs the `graphql` package, which is not an app
// dependency: it is taken from linc-app's node_modules by default.
//
//   node scripts/validate-graphql.js [schema.graphql(.gz)] [path/to/node_modules]

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const LINC = path.resolve(__dirname, '../../../..');
const schemaFile = process.argv[2] || path.join(LINC, 'src/integrations/shopify/gql/schema/admin-2026-10.graphql.gz');
const modules = process.argv[3] || path.join(LINC, 'node_modules');

const { buildSchema, parse, validate } = require(require.resolve('graphql', { paths: [modules] }));
const raw = fs.readFileSync(schemaFile);
const schema = buildSchema((schemaFile.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString());
const docs = require('../src/shopify/documents');

let failed = 0;
for (const [name, text] of Object.entries(docs)) {
  const errors = validate(schema, parse(text));
  if (errors.length) {
    failed += 1;
    console.log(`FAIL ${name}`);
    for (const e of errors) console.log(`  - ${e.message}`);
  } else {
    console.log(`ok   ${name}`);
  }
}
console.log(failed ? `\n${failed} document(s) invalid against ${path.basename(schemaFile)}` : `\nall ${Object.keys(docs).length} documents valid against ${path.basename(schemaFile)}`);
process.exit(failed ? 1 : 0);
