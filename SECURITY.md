# Security policy

Hopline moves people's files, so security reports are taken seriously and handled first.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅        |
| < 1.0   | ❌        |

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

- Use GitHub's private reporting: **Security → Report a vulnerability** on
  [vishwajitvm/Hopline](https://github.com/vishwajitvm/Hopline/security/advisories/new), or
- email **vishwajitmall50@gmail.com** with the subject `Hopline security`.

Please include what you found, how to reproduce it, the affected component (web, desktop, CLI, server, TURN)
and version, and the impact you expect. You'll get an acknowledgement within 72 hours and a status update within
7 days. Once a fix ships, you're credited in the release notes unless you'd rather not be.

## Scope

In scope: the web app, desktop app (including Direct mode), CLI, signaling server, the TURN configuration and the
Docker images in this repository.

Out of scope: third-party hosting, browsers and operating systems themselves, and denial of service that needs
more traffic than one attacker reasonably has.

## How Hopline is secured

- [Threat model and design](docs/security.md)
- [Penetration test report](docs/security/vapt-report.md)
- Run the active test suite yourself against a deployment you own: `npm run vapt`
