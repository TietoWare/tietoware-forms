# Security policy

Do not report security vulnerabilities in public GitHub issues. Contact TietoWare through the private security contact configured for the repository.

Never commit integration secrets, production form data, generated customer schemas, `.env` files or credentials. Rotate a key immediately if it may have entered browser output, logs, package contents or source history.

Supported releases follow the latest minor line. Security fixes are released as new immutable semantic versions.
