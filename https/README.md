# Local HTTPS certificates

Place the local TLS key and certificate here. The defaults are:

- `private.key`
- `self-sign.cert`

Certificate material is ignored by Git. Enable HTTPS with
`BIM_STUDIO_HTTPS=true` or `bim-studio.ps1 ... -Https`.

For LAN access, the certificate must contain the actual IP address or host name
in its Subject Alternative Name (SAN). A Common Name containing an IP and port
is not sufficient for current browsers, and an untrusted certificate can keep
WebXR/AR/VR APIs unavailable even though the HTTPS page itself opens.
