@AGENTS.md

# Secrets and Private Infrastructure

This repository is public. Never write anything that identifies or grants access to private infrastructure into a file, commit, commit message, PR title or body, code comment, test fixture, or documentation. This applies to files that are gitignored too — they get pasted, attached, and copied into tracked files later.

Never commit or write down:

- Server addresses, hostnames, or IPs of personal or private infrastructure, and the ports they listen on
- API keys, tokens, certificates, private keys (`.p8`, `.p12`, `.pem`, `.mobileprovision`), passwords, and connection strings
- Account identifiers, device tokens, UDIDs, team IDs, and license or subscription identifiers
- Anything a third party could use to locate, impersonate, or connect to the operator's systems

Refer to these as configuration instead: "the push server origin", "the APNs auth key", "the operator's host". Design docs describe the *shape* of a value, never the value. Everything concrete belongs in local configuration or a secret store that is never committed.

When something private has to be discussed in the terminal to get work done, keep it in the shell session — do not echo it back into a file or a commit.
