/**
 * The pipeline implementation: resource registry, backend executor, store event
 * sink and the pipeline itself. Internal to the package: other `src/` areas and
 * tests import it, but it is outside the frozen `public-types.ts` barrel and no
 * package entry point exports it.
 */

export type { HttpBackendExecutorOptions } from './backend-http';
export {
  extractPathParameterNames,
  findUnparsedBraceToken,
  HttpBackendExecutor,
  validateBackendRequestShape,
} from './backend-http';
export type { CreateExecutionPipelineOptions } from './pipeline';
export { createExecutionPipeline } from './pipeline';
export { createResourceRegistry } from './registry';
export type { CreateStoreEventSinkOptions } from './store-event-sink';
export { createStoreEventSink } from './store-event-sink';
export type { FieldError, ValidationResult, Validator } from './validation';
export { compileJsonSchema, isObjectSchemaNode } from './validation';
