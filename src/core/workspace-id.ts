/**
 * The bound on a workspace id (a session key, a workspace key, a worktree's directory name).
 *
 * It exists so a refusal can always be sent. Every refusal echoes the key, so a key near
 * `MAX_FRAME_BYTES` would make its own refusal unencodable and the named answer would degrade to
 * silence. 200 keeps every echo-bearing detail far under the frame cap; a controller storing keys
 * should refuse the same bound so both halves reject the same population. It lives in `core/` so
 * the wire codec can enforce it on an inventory entry without the protocol closure reaching the
 * workspace provider.
 */
export const MAX_WORKSPACE_ID_LENGTH = 200;
