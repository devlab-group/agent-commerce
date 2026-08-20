/**
 * src/core/execution
 *
 * The execution pipeline implementation: resource registry, backend executor,
 * event bus and the pipeline itself. Not part of the frozen `public-types.ts`
 * barrel — this is implementation, not contract — but exported as a stable
 * subpath so `src/gateway` (and tests) can wire it up.
 */

export type { HttpBackendExecutorOptions } from './backend-http.js';
export {
  extractPathParameterNames,
  findUnparsedBraceToken,
  HttpBackendExecutor,
  validateBackendRequestShape,
} from './backend-http.js';
export type { CreateEventBusOptions, EventBus } from './event-bus.js';
export { createEventBus } from './event-bus.js';
export type { CreateExecutionPipelineOptions } from './pipeline.js';
export { createExecutionPipeline } from './pipeline.js';
export { createResourceRegistry, ResourceRegistryImpl } from './registry.js';
export type { FieldError, ValidationResult, Validator } from './validation.js';
export { compileJsonSchema, isObjectSchemaNode } from './validation.js';
