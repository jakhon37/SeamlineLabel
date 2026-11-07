# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 3.x     | :white_check_mark: |
| < 3.0 (LabelMeV2, Qt) | :x: |

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly:

### How to Report

1. **Do NOT** open a public GitHub issue
2. Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability)
3. Provide detailed information:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if available)

### What to Expect

- **Acknowledgment**: Within 48 hours
- **Assessment**: Within 1 week
- **Fix Timeline**: Depends on severity
  - Critical: Within 7 days
  - High: Within 30 days
  - Medium: Within 90 days
  - Low: Next regular release

### Security Best Practices

When using labelme:

1. **Input Validation**: Always validate annotation files from untrusted sources
2. **File Paths**: Be cautious when loading files from untrusted directories
3. **Dependencies**: Keep all dependencies up to date
4. **Permissions**: Run with minimal required permissions
5. **Network**: Be aware that AI features may send data to remote servers

### Known Security Considerations

- **Image Files**: Labelme loads images using PIL/Pillow. Ensure images come from trusted sources
- **JSON Files**: Annotation files are loaded as JSON. Malformed files could cause crashes
- **AI Features**: Some AI features may send data to external services (configurable)

## Dependency Security

This project uses:
- Regular dependency updates via Dependabot (configured in `.github/dependabot.yml`)
- Automated security scanning via GitHub's security features
- Pin dependencies to specific versions in production

## Updates

Security updates will be:
1. Released as patch versions (e.g., 0.0.x)
2. Documented in [CHANGELOG.md](CHANGELOG.md)
3. Announced in release notes
