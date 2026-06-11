import { Router } from 'express';
import { registerAttachmentRoutes } from './attachments';
import { registerSendAbortRoutes } from './sendAbort';
import { registerMessagesHistoryRoutes } from './messagesHistory';
export { setupChatProxy } from './proxy';

const router = Router();

registerAttachmentRoutes(router);
registerSendAbortRoutes(router);
registerMessagesHistoryRoutes(router);

export default router;
