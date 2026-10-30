import { userFacingErrorMessage } from '@shiye/shared';
import { createApiClient } from '../../web-shared/api-client';

export const { api, cancelPendingReadRequests, onSessionExpired } = createApiClient(userFacingErrorMessage);
