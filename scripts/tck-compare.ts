// Compare A2A TCK results with the expected failures, skips and shared skip
// messages in src/support/a2a.json
//
//   npx tsx scripts/tck-compare.ts <reports/junitreport.xml>
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSupportRecord, type SupportRecord } from './support-record';

export type UpstreamSuite = NonNullable<NonNullable<SupportRecord['conformance']>['upstream']>;

export interface TckCase {
  /** The JUnit report's `classname::name` */
  readonly test: string;
  readonly outcome: 'passed' | 'failed' | 'skipped';
  /** The failure, error or skip message; empty for a pass */
  readonly message: string;
}

// Read attributes one quoted value at a time: a value may contain `>`
const ATTRIBUTES = String.raw`((?:\s+[\w:.-]+="[^"]*")*)\s*`;
const TESTCASE = new RegExp(
  String.raw`<testcase\b${ATTRIBUTES}(?:\/>|>([\s\S]*?)<\/testcase>)`,
  'g',
);
const RESULT = new RegExp(String.raw`<(failure|error|skipped)\b${ATTRIBUTES}\/?>`);
const ENTITIES: Readonly<Record<string, string>> = {
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  amp: '&',
};

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
    return ENTITIES[name] ?? entity;
  });
}

function attributes(text: string): Map<string, string> {
  return new Map(
    [...text.matchAll(/([\w:.-]+)="([^"]*)"/g)].map(([, name = '', value = '']) => [
      name,
      decode(value),
    ]),
  );
}

/** Parse pytest JUnit cases, treating error entries as failures */
export function parseJunit(xml: string): TckCase[] {
  return [...xml.matchAll(TESTCASE)].map(([, attrs = '', body = '']) => {
    const testcase = attributes(attrs);
    const result = RESULT.exec(body);
    const test = `${testcase.get('classname') ?? ''}::${testcase.get('name') ?? ''}`;
    if (result === null) return { test, outcome: 'passed', message: '' };
    const message = attributes(result[2] ?? '').get('message') ?? '';
    return { test, outcome: result[1] === 'skipped' ? 'skipped' : 'failed', message };
  });
}

/** Check recorded outcomes and shared skip messages; return any mismatches */
export function compareTck(cases: readonly TckCase[], suite: UpstreamSuite): string[] {
  if (cases.length === 0) return ['the report holds no test cases'];
  const tests = suite.results.map((result) => result.test);
  const messages = suite.skipClasses.flatMap((skipClass) => skipClass.messages);
  const twice = (values: readonly string[]) => values.filter((v, i) => values.indexOf(v) !== i);
  const problems = [
    ...twice(tests).map((test) => `${test}: listed more than once in the record`),
    ...twice(messages).map((message) => `skip message "${message}": listed more than once`),
  ];
  const listed = new Map(suite.results.map((result) => [result.test, result]));
  const skipMessages = new Set(messages);
  const ran = new Set<string>();
  const seenMessages = new Set<string>();
  for (const run of cases) {
    ran.add(run.test);
    const entry = listed.get(run.test);
    if (entry === undefined) {
      if (run.outcome === 'skipped' && skipMessages.has(run.message)) {
        seenMessages.add(run.message);
      } else if (run.outcome !== 'passed') {
        problems.push(
          `${run.test}: ${run.outcome}, and the record does not list it: ${run.message}`,
        );
      }
    } else if (run.outcome === 'passed') {
      problems.push(`${run.test}: passed, but the record lists it as ${entry.outcome}`);
    } else if (run.outcome !== entry.outcome) {
      problems.push(
        `${run.test}: ${run.outcome}, but the record lists it as ${entry.outcome}: ${run.message}`,
      );
    } else if (!run.message.includes(entry.message)) {
      problems.push(
        `${run.test}: ${run.outcome} with a message that does not contain "${entry.message}": ${run.message}`,
      );
    }
  }
  for (const entry of suite.results) {
    if (!ran.has(entry.test)) problems.push(`${entry.test}: in the record, but not in the run`);
  }
  for (const message of skipMessages) {
    if (!seenMessages.has(message)) {
      problems.push(`skip message "${message}": in the record, but no test skipped with it`);
    }
  }
  return problems;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (path === undefined) {
    console.error('usage: tsx scripts/tck-compare.ts <junitreport.xml>');
    process.exit(2);
  }
  if (!existsSync(path)) {
    console.error(`no report at ${path}: the TCK did not finish`);
    process.exit(1);
  }
  const suite = readSupportRecord('a2a').conformance?.upstream;
  if (suite === undefined) {
    console.error('src/support/a2a.json records no upstream suite');
    process.exit(2);
  }
  const cases = parseJunit(readFileSync(path, 'utf8'));
  const count = (outcome: TckCase['outcome']) => cases.filter((c) => c.outcome === outcome).length;
  console.log(
    `TCK: ${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped`,
  );
  const problems = compareTck(cases, suite);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(`${problems.length} difference(s) from src/support/a2a.json`);
    process.exit(1);
  }
  console.log('The run matches src/support/a2a.json');
}
