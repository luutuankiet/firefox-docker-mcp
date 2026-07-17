/**
 * Common types shared across the Firefox DevTools MCP server
 */

export type McpContentItem =
  | { type: 'text'; text: string; [key: string]: unknown }
  | { type: 'image'; data: string; mimeType: string; [key: string]: unknown };

export interface McpToolResponse {
  [key: string]: unknown;
  content: McpContentItem[];
  /**
   * Native MCP structured result. Clients that support it (including the
   * mcpproxy chain) render this as a real JSON object — no string-in-string
   * escape inflation — and drop the text fallback in content[].
   */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
