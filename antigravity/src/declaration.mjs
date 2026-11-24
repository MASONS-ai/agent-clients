// Single authoritative declaration builder for masons-antigravity.
// Declares adapter_managed_turn when the plugin Sidecar idle-wakeup daemon is active,
// and session_attached_pull otherwise; presence_v1 is omitted until tab-close signaling exists.
export const ANTIGRAVITY_CAPABILITIES = Object.freeze([
  'background_exchange_v1',
  'runtime-explicit-session-model-v1',
]);

export function antigravityDeclaration({ idleWakeup = false } = {}) {
  return Object.freeze({
    runtime_kind: 'antigravity',
    execution_surface: 'owner_attached',
    background_exchange_mode: idleWakeup ? 'adapter_managed_turn' : 'session_attached_pull',
    runtime_capabilities: ANTIGRAVITY_CAPABILITIES,
  });
}

export const ANTIGRAVITY_DECLARATION = antigravityDeclaration({ idleWakeup: false });

export function effectiveCapabilities(registrationResponse) {
  if (!registrationResponse || !Array.isArray(registrationResponse.runtime_capabilities)) {
    return null;
  }
  return new Set(
    registrationResponse.runtime_capabilities.filter((cap) => typeof cap === 'string' && cap.length > 0),
  );
}

export function assertEffectiveDeclaration(registrationResponse, declared = ANTIGRAVITY_DECLARATION) {
  const effective = effectiveCapabilities(registrationResponse);
  // Absence of runtime_capabilities denotes a pre-obligation deployment rather than an empty set.
  if (effective !== null) {
    for (const cap of declared.runtime_capabilities) {
      if (!effective.has(cap)) {
        throw Object.assign(new Error('registration_capability_not_effective'), {
          code: 'registration_capability_not_effective',
          capability: cap,
        });
      }
    }
  }
  if (registrationResponse.execution_surface !== undefined &&
      registrationResponse.execution_surface !== declared.execution_surface) {
    throw Object.assign(new Error('registration_declaration_mismatch'), {
      code: 'registration_declaration_mismatch',
    });
  }
  if (registrationResponse.background_exchange_mode !== undefined &&
      registrationResponse.background_exchange_mode !== declared.background_exchange_mode) {
    throw Object.assign(new Error('registration_declaration_mismatch'), {
      code: 'registration_declaration_mismatch',
    });
  }
  return effective ?? new Set(declared.runtime_capabilities);
}
