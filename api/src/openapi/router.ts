import { Router } from 'express';
import { getOpenApiDocument } from './document';

const openApiRouter = Router();

openApiRouter.get('/openapi.json', (_req, res) => {
  res.json(getOpenApiDocument());
});

export default openApiRouter;
