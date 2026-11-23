import { describe, expect, it } from 'vitest';
import { readSupportRecord } from '../../scripts/support-record';
import { compareTck, parseJunit, type UpstreamSuite } from '../../scripts/tck-compare';

const SUITE: UpstreamSuite = {
  repo: 'a2aproject/a2a-tck',
  commit: '5e6f37c2d38eb3d7684686243c34d365c83df49b',
  command: 'run_tck.py --level must',
  workflow: '.github/workflows/ci.yml',
  job: 'tck',
  results: [
    {
      test: 'm.TestSend::test_send',
      outcome: 'failed',
      message: 'Text parts are not supported',
      reason: 'text part',
    },
    {
      test: 'm.TestGet::test_get',
      outcome: 'skipped',
      message: 'send_message failed',
      reason: 'prerequisite',
    },
  ],
  skipClasses: [{ reason: 'transport', messages: ["Transport 'grpc' not configured"] }],
};

const FAILED_SEND =
  '<testcase classname="m.TestSend" name="test_send"><failure message="Operation failed: Text parts are not supported: &quot;x&quot;">trace</failure></testcase>';
const SKIPPED_GET =
  '<testcase classname="m.TestGet" name="test_get"><skipped type="pytest.skip" message="send_message failed: Text parts">at line 1</skipped></testcase>';
const GRPC_SKIP =
  '<testcase classname="m.TestCard" name="test_card[grpc]"><skipped type="pytest.skip" message="Transport &apos;grpc&apos; not configured">x</skipped></testcase>';
const PASSED = '<testcase classname="m.TestCard" name="test_card[jsonrpc]" time="0.001" />';

function report(...cases: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest">${cases.join('')}</testsuite></testsuites>`;
}

function compare(...cases: string[]): string[] {
  return compareTck(parseJunit(report(...cases)), SUITE);
}

describe('parseJunit', () => {
  it('reads passes, failures, errors and skips with decoded messages', () => {
    const xml = report(
      PASSED,
      '<testcase classname="m.A" name="test_a[x]"><failure message="a &gt; b &amp;&#10;c &#x41;">t</failure></testcase>',
      '<testcase classname="m.B" name="test_b"><error message="setup broke">t</error></testcase>',
      GRPC_SKIP,
    );

    expect(parseJunit(xml)).toEqual([
      { test: 'm.TestCard::test_card[jsonrpc]', outcome: 'passed', message: '' },
      { test: 'm.A::test_a[x]', outcome: 'failed', message: 'a > b &\nc A' },
      { test: 'm.B::test_b', outcome: 'failed', message: 'setup broke' },
      {
        test: 'm.TestCard::test_card[grpc]',
        outcome: 'skipped',
        message: "Transport 'grpc' not configured",
      },
    ]);
  });

  it('keeps a raw > inside an attribute value', () => {
    const xml = report(
      '<testcase classname="m.C" name="test_c"><skipped message="a>b" /></testcase>',
    );

    expect(parseJunit(xml)).toEqual([{ test: 'm.C::test_c', outcome: 'skipped', message: 'a>b' }]);
  });
});

describe('compareTck', () => {
  it('finds no difference when every failure and skip is recorded', () => {
    expect(compare(FAILED_SEND, SKIPPED_GET, GRPC_SKIP, PASSED)).toEqual([]);
  });

  it('reports a failure the record does not list', () => {
    const extra =
      '<testcase classname="m.TestNew" name="test_new"><failure message="boom">t</failure></testcase>';

    expect(compare(FAILED_SEND, SKIPPED_GET, GRPC_SKIP, extra)).toEqual([
      'm.TestNew::test_new: failed, and the record does not list it: boom',
    ]);
  });

  it('reports a skip whose message is in no skip class', () => {
    const extra =
      '<testcase classname="m.TestNew" name="test_new"><skipped message="Transport \'grpc\' not ready">t</skipped></testcase>';

    expect(compare(FAILED_SEND, SKIPPED_GET, GRPC_SKIP, extra)).toEqual([
      "m.TestNew::test_new: skipped, and the record does not list it: Transport 'grpc' not ready",
    ]);
  });

  it('reports a listed test that now passes', () => {
    const passing = '<testcase classname="m.TestSend" name="test_send" />';

    expect(compare(passing, SKIPPED_GET, GRPC_SKIP)).toEqual([
      'm.TestSend::test_send: passed, but the record lists it as failed',
    ]);
  });

  it('reports a listed test that is missing from the run', () => {
    expect(compare(FAILED_SEND, GRPC_SKIP)).toEqual([
      'm.TestGet::test_get: in the record, but not in the run',
    ]);
  });

  it('reports a listed test whose outcome changed between failed and skipped', () => {
    const skipped =
      '<testcase classname="m.TestSend" name="test_send"><skipped message="Text parts are not supported">t</skipped></testcase>';

    expect(compare(skipped, SKIPPED_GET, GRPC_SKIP)).toEqual([
      'm.TestSend::test_send: skipped, but the record lists it as failed: Text parts are not supported',
    ]);
  });

  it('reports a listed failure that now fails for another reason', () => {
    const other =
      '<testcase classname="m.TestSend" name="test_send"><failure message="Operation failed: Internal error">t</failure></testcase>';

    expect(compare(other, SKIPPED_GET, GRPC_SKIP)).toEqual([
      'm.TestSend::test_send: failed with a message that does not contain "Text parts are not supported": Operation failed: Internal error',
    ]);
  });

  it('reports a skip message no test skipped with', () => {
    expect(compare(FAILED_SEND, SKIPPED_GET, PASSED)).toEqual([
      `skip message "Transport 'grpc' not configured": in the record, but no test skipped with it`,
    ]);
  });

  it('reports a test or skip message the record lists twice', () => {
    const doubled: UpstreamSuite = {
      ...SUITE,
      results: [...SUITE.results, ...SUITE.results.slice(0, 1)],
      skipClasses: [...SUITE.skipClasses, ...SUITE.skipClasses],
    };

    expect(compareTck(parseJunit(report(FAILED_SEND, SKIPPED_GET, GRPC_SKIP)), doubled)).toEqual([
      'm.TestSend::test_send: listed more than once in the record',
      `skip message "Transport 'grpc' not configured": listed more than once`,
    ]);
  });

  it('refuses a report with no test cases', () => {
    expect(compare()).toEqual(['the report holds no test cases']);
  });
});

describe('the A2A record', () => {
  it('records the TCK run the tck job checks', () => {
    const suite = readSupportRecord('a2a').conformance?.upstream;

    expect(suite).toMatchObject({
      repo: 'a2aproject/a2a-tck',
      workflow: '.github/workflows/ci.yml',
      job: 'tck',
    });
  });
});
