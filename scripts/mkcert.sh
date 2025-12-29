#!/bin/bash
#
# Generate self-signed SSL certificate for localhost development
#

set -e

CERT_FILE="localhost.crt"
KEY_FILE="localhost.key"

echo "🔐 Generating self-signed certificate for localhost..."

openssl req -x509 \
    -out "$CERT_FILE" \
    -keyout "$KEY_FILE" \
    -newkey rsa:2048 \
    -nodes \
    -sha256 \
    -days 365 \
    -subj '/CN=localhost' \
    -extensions EXT \
    -config <(cat <<EOF
[dn]
CN=localhost

[req]
distinguished_name = dn

[EXT]
subjectAltName = DNS:localhost, IP:127.0.0.1
keyUsage = digitalSignature
extendedKeyUsage = serverAuth
EOF
)

echo "✅ Certificate generated successfully!"
echo "   - Certificate: $CERT_FILE"
echo "   - Private Key: $KEY_FILE"
