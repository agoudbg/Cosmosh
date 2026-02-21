# FAQ

## Is Cosmosh only for remote SSH?

No. Cosmosh supports both remote SSH sessions and local terminal workflows.

## Can I use password and key authentication?

Yes. Configure either password or private key based on your server policy.

## What should I do if host fingerprint changes?

Treat it as a security event. Verify the new fingerprint through a trusted channel before accepting it.

## What is the best first-use path?

Start from [Getting Started](./getting-started.md), then follow [Install & Setup](./install-and-setup.md).

## Why does connection work for one host but not another?

Most often this is host-side policy or network path difference. Compare host, port, auth method, and routing context.

## Do I need to close sessions manually?

Yes, explicit close is recommended to keep session state clean and avoid orphaned operations.
