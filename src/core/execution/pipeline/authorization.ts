// Verifies and reserves the authorization a resource requires, before its payment is reserved
import type { AuthorizationProvider, AuthorizationVerification } from '../../domain/authorization';
import type { AuthorizationMethodName } from '../../domain/common';
import type { PaymentRequirement } from '../../domain/payment';
import type { CanonicalRequest } from '../../domain/request';
import type { CommerceResource } from '../../domain/resource';
import { CommerceError, describeError, isCommerceError } from '../../errors';
import type { AuthorizationHold, PipelineContext } from './context';

// The provider for each method a resource requires, in the resource's order.
// Config refuses a method that is not enabled at load; it is checked again
// because missing it here would serve the resource with no authorization.
export function resolveAuthorizationProviders(
  providers: readonly AuthorizationProvider[],
  resource: CommerceResource,
  requestId: string,
): readonly AuthorizationProvider[] {
  const required = resource.authorization?.required ?? [];
  return required.map((method: AuthorizationMethodName) => {
    const found = providers.find((provider) => provider.name === method);
    if (!found) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${resource.id}" requires authorization method "${method}", which is not enabled`,
        { requestId, resourceId: resource.id },
      );
    }
    return found;
  });
}

export type AuthorizeAndReserve = (
  request: CanonicalRequest,
  resource: CommerceResource,
  providers: readonly AuthorizationProvider[],
  requirement: PaymentRequirement,
  input: unknown,
) => Promise<AuthorizationHold | undefined>;

export function createAuthorizeAndReserve(ctx: PipelineContext): AuthorizeAndReserve {
  const { options, safeEmit, buildEvent } = ctx;

  // Verify and reserve what the resource requires, or undefined if it requires
  // none. Runs after payment verification, which has no side effect, so a bad
  // payment proof cannot burn a reservation.
  async function authorizeAndReserve(
    request: CanonicalRequest,
    resource: CommerceResource,
    providers: readonly AuthorizationProvider[],
    requirement: PaymentRequirement,
    input: unknown,
  ): Promise<AuthorizationHold | undefined> {
    if (providers.length === 0) return undefined;

    const submission = request.authorization;
    const provider = providers.find((candidate) => candidate.name === submission?.method);
    // A request carries one proof, so a resource requiring two methods is
    // refused here rather than half-checked
    const unmet = providers.filter((candidate) => candidate !== provider).map((c) => c.name);

    if (submission === undefined || provider === undefined || unmet.length > 0) {
      await safeEmit(
        buildEvent({
          type: 'authorization.rejected',
          requestId: request.requestId,
          resourceId: resource.id,
          adapter: request.protocol,
          status: 'error',
          data: { reason: 'AUTHORIZATION_REQUIRED', methods: unmet },
        }),
      );
      throw new CommerceError(
        'AUTHORIZATION_REQUIRED',
        `Resource "${resource.id}" requires authorization: ${unmet.join(', ')}`,
        {
          requestId: request.requestId,
          resourceId: resource.id,
          details: { required: providers.map((candidate) => candidate.name), missing: unmet },
        },
      );
    }

    let verification: AuthorizationVerification;
    try {
      verification = await provider.verifyAndReserve({
        requestId: request.requestId,
        resourceId: resource.id,
        input,
        submission,
        requirement,
      });
    } catch (error) {
      // An untyped throw says nothing about whose fault it was. Unavailable is
      // honest and retryable; invalid would blame the buyer for our outage.
      const mapped = isCommerceError(error)
        ? error
        : new CommerceError(
            'AUTHORIZATION_PROVIDER_UNAVAILABLE',
            'Authorization provider is unavailable',
            {
              requestId: request.requestId,
              resourceId: resource.id,
              cause: error,
            },
          );
      await safeEmit(
        buildEvent({
          type: 'authorization.rejected',
          requestId: request.requestId,
          resourceId: resource.id,
          adapter: request.protocol,
          status: 'error',
          data: { reason: mapped.code, method: provider.name },
        }),
      );
      throw mapped;
    }

    await safeEmit(
      buildEvent({
        type: 'authorization.verified',
        requestId: request.requestId,
        resourceId: resource.id,
        adapter: request.protocol,
        status: 'ok',
        data: { method: verification.method, reference: verification.reference },
      }),
    );

    const context = { requestId: request.requestId, resourceId: resource.id };
    return {
      record: {
        method: verification.method,
        reference: verification.reference,
        ...(verification.metadata !== undefined ? { metadata: verification.metadata } : {}),
      },
      async finalize(action) {
        try {
          await provider[action](verification.reservationId, context);
        } catch (error) {
          // A failure leaves the reservation reserved, which is still
          // unspendable, so the caller's outcome stands
          options.logger.error(
            { err: describeError(error), requestId: request.requestId, action },
            'Authorization finalization failed; the reservation stays reserved',
          );
        }
      },
    };
  }

  return authorizeAndReserve;
}
