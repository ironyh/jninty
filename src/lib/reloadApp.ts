/**
 * Single app-refresh boundary for post-Replace import recovery.
 * Closing a completed Replace import must reinitialize queries, settings and
 * listeners; routing the reload through this helper lets tests observe the
 * boundary without real navigation.
 */
export function reloadApp(): void {
  window.location.reload();
}
