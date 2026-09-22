import { z } from 'zod';
import type { JsonSchema, ToolSpec } from '../types.js';
import type { Tool } from './types.js';

const schemaCache = new WeakMap<Tool<any>, JsonSchema>();

export function toolJsonSchema(tool: Tool<any>): JsonSchema {
  if (tool.jsonSchema) return tool.jsonSchema;
  const cached = schemaCache.get(tool);
  if (cached) return cached;
  const schema = z.toJSONSchema(tool.schema!, { target: 'draft-7', io: 'input' }) as JsonSchema;
  delete schema.$schema;
  schemaCache.set(tool, schema);
  return schema;
}

export function toolSpec(tool: Tool<any>): ToolSpec {
  return { name: tool.name, description: tool.description, inputSchema: toolJsonSchema(tool) };
}
