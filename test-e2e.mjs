/**
 * E2E test: Start MCP server with --connect-existing,
 * call navigate_page, verify response contains both text + image.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js', '--connect-existing', '--marionette-port', '2828'],
});

const client = new Client({ name: 'test', version: '0.1.0' });

try {
  console.log('Connecting to MCP server...');
  await client.connect(transport);
  console.log('Connected.');

  // List tools
  const { tools } = await client.listTools();
  console.log(`Available tools: ${tools.length}`);

  // Call navigate_page
  console.log('\nCalling navigate_page(https://example.com)...');
  const result = await client.callTool({
    name: 'navigate_page',
    arguments: { url: 'https://example.com' },
  });

  const content = result.content || [];
  const types = content.map(c => c.type);
  console.log('Response content types:', types);

  const textBlocks = content.filter(c => c.type === 'text');
  textBlocks.forEach(t => console.log('  text:', t.text));

  const hasImage = content.some(c => c.type === 'image');
  const hasText = content.some(c => c.type === 'text');

  if (hasText && hasImage) {
    const img = content.find(c => c.type === 'image');
    console.log(`\n✅ SUCCESS: navigate_page returned text + image (${(img.data.length / 1024).toFixed(1)}KB base64)`);
  } else {
    console.log(`\n❌ FAIL: expected text+image, got types: ${types}`);
    process.exit(1);
  }
} catch (err) {
  console.error('Test error:', err.message || err);
  process.exit(1);
} finally {
  await client.close().catch(() => {});
}
