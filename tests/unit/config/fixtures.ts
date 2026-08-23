/** Shared valid-config fixture, mirroring config.example.yaml. */
export function validRawConfig(): Record<string, unknown> {
  return {
    version: 1,
    merchant: {
      id: 'demo-store',
      name: 'Demo Data Store',
      publicBaseUrl: 'http://localhost:8080',
    },
    server: {
      port: 8080,
      host: '0.0.0.0',
    },
    storage: {
      receipts: {
        driver: 'sqlite',
        path: './data/receipts.sqlite',
      },
    },
    protocols: {
      http: { enabled: true },
      mcp: { enabled: true, mountPath: '/mcp' },
    },
    resources: {
      weather_basic: {
        name: 'Basic Weather',
        description: 'Current basic weather for a city. Free.',
        input: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
        backend: {
          type: 'http',
          method: 'GET',
          url: 'http://localhost:3000/api/weather/{city}',
          timeoutMs: 5000,
        },
        pricing: { type: 'free' },
        expose: ['http', 'mcp'],
      },
      market_report: {
        name: 'Premium Market Report',
        description: 'Latest premium market analysis. Paid resource.',
        input: { type: 'object', properties: {}, additionalProperties: false },
        backend: {
          type: 'http',
          method: 'GET',
          url: 'http://localhost:3000/api/report',
          timeoutMs: 10000,
        },
        pricing: { type: 'fixed', amount: '0.01', currency: 'USDC' },
        expose: ['http', 'mcp'],
        payments: ['x402'],
      },
    },
    payments: {
      x402: {
        enabled: true,
        network: 'eip155:84532',
        rpcUrl: 'http://127.0.0.1:8545',
        asset: '0x1111111111111111111111111111111111111111',
        assetName: 'MockUSDC',
        assetVersion: '2',
        assetDecimals: 6,
        payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        maxTimeoutSeconds: 120,
        facilitator: { mode: 'local', signerPrivateKey: '0xFACILITATOR_KEY' },
      },
    },
  };
}
