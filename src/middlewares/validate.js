export const validate = (schemas) => (req, res, next) => {
  try {
    if (schemas.body) req.body = schemas.body.parse(req.body);
    if (schemas.query) {
      const parsedQuery = schemas.query.parse(req.query);
      Object.defineProperty(req, 'query', {
        value: parsedQuery,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    if (schemas.params) {
      const parsedParams = schemas.params.parse(req.params);
      Object.defineProperty(req, 'params', {
        value: parsedParams,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    next();
  } catch (err) {
    next(err);
  }
};
