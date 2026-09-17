/**
 * Open string-valued environment map: every variable optional, unknown keys
 * allowed — Node's own typing of `process.env` (NodeJS.ProcessEnv extends
 * Dict<string>). Helper signatures take this instead of NodeJS.ProcessEnv
 * because Next.js augments the global ProcessEnv with a *required* NODE_ENV
 * (next/types/global.d.ts), which would force tests to fake NODE_ENV when
 * passing partial env objects.
 */
export type PartialEnv = { [key: string]: string | undefined };
