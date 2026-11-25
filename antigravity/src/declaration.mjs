// Single authoritative declaration builder for masons-antigravity.
// Declares adapter_managed_turn + presence_v1 when an active idle-wakeup driver (Sidecar or ACP CLI)
// is running, and session_attached_pull (without presence_v1) on bare CLI so non-wakeable sessions
// never falsely advertise online presence.
export const CONVERSATION_TYPING_CAPABILITY = 'conversation_typing_v1';
export const PRESENCE_CAPABILITY = 'presence_v1';
export const SESSION_NAME_APPLY_CAPABILITY = 'session_name_apply_v1';

export const ANTIGRAVITY_CAPABILITIES = Object.freeze([
  'background_exchange_v1',
  'runtime-explicit-session-model-v1',
  CONVERSATION_TYPING_CAPABILITY,
]);

// Capabilities managed by this client whose presence/absence must match Services' effective set exactly.
const MANAGED_CAPABILITIES = new Set([
  ...ANTIGRAVITY_CAPABILITIES,
  PRESENCE_CAPABILITY,
  SESSION_NAME_APPLY_CAPABILITY,
]);

export function antigravityDeclaration({
  idleWakeup = false,
  sessionNameApply = false,
} = {}) {
  const caps = Object.freeze([
    ...ANTIGRAVITY_CAPABILITIES,
    ...(idleWakeup ? [PRESENCE_CAPABILITY] : []),
    ...(sessionNameApply ? [SESSION_NAME_APPLY_CAPABILITY] : []),
  ]);
  return Object.freeze({
    runtime_kind: 'antigravity',
    execution_surface: 'owner_attached',
    background_exchange_mode: idleWakeup ? 'adapter_managed_turn' : 'session_attached_pull',
    runtime_capabilities: caps,
  });
}

export function declarationFromRegistration(registration) {
  const caps = Array.isArray(registration?.response?.runtime_capabilities)
    ? registration.response.runtime_capabilities
    : [];
  const idleWakeup = registration?.response?.background_exchange_mode === 'adapter_managed_turn';
  return antigravityDeclaration({
    idleWakeup,
    sessionNameApply: caps.includes(SESSION_NAME_APPLY_CAPABILITY),
  });
}

export const ANTIGRAVITY_DECLARATION = antigravityDeclaration({ idleWakeup: false, sessionNameApply: false });

export function capabilitiesEqual(actual, expected) {
  const actualSet = new Set(Array.isArray(actual) ? actual.filter((c) => typeof c === 'string' && c.length > 0) : []);
  const expectedSet = new Set(Array.isArray(expected) ? expected.filter((c) => typeof c === 'string' && c.length > 0) : []);
  for (const cap of expectedSet) {
    if (!actualSet.has(cap)) return false;
  }
  for (const cap of MANAGED_CAPABILITIES) {
    if (actualSet.has(cap) !== expectedSet.has(cap)) return false;
  }
  return true;
}

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
    const declaredSet = new Set(declared.runtime_capabilities);
    for (const cap of declaredSet) {
      if (!effective.has(cap)) {
        throw Object.assign(new Error('registration_capability_not_effective'), {
          code: 'registration_capability_not_effective',
          capability: cap,
        });
      }
    }
    for (const cap of MANAGED_CAPABILITIES) {
      if (effective.has(cap) && !declaredSet.has(cap)) {
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
