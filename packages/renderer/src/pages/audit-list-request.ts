/**
 * Determines whether an audit list response still belongs to the latest request.
 *
 * @param requestId Request identifier captured before the asynchronous call.
 * @param latestRequestId Identifier of the newest request currently in flight.
 * @returns Whether the response may update the audit list state.
 */
export const isLatestAuditListRequest = (requestId: number, latestRequestId: number): boolean => {
  return requestId === latestRequestId;
};
