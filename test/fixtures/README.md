# Test fixtures

## `apple-jws-chain.ts`

A throwaway certificate chain for `test/apple-jws.test.ts`. **Nothing here is
secret and nothing is used in production** — the private keys are generated for
the test and committed on purpose.

It exists because nobody can mint a certificate chain under Apple's real root.
Without a chain the verifier will accept, only its rejection paths would ever
execute, and "rejects everything" passes those tests perfectly.

So the tests pass `budjTestRootPem` as the trust anchor override to exercise the
happy path, and separately assert that the **default** anchor — Apple's pinned
root — rejects this same chain.

`rogueRootDer` is the interesting one: a self-signed certificate whose subject
and issuer are byte-for-byte Apple's (`CN=Apple Root CA - G3, OU=Apple
Certification Authority, O=Apple Inc., C=US`). A verifier that anchors trust by
comparing *names* accepts it. That is the bug this fixture exists to catch.

### Regenerating

```bash
D=$(mktemp -d) && cd "$D"
key() { openssl ecparam -name prime256v1 -genkey -noout -out "$1"; }

key root.key
openssl req -x509 -new -key root.key -sha256 -days 7300 -out root.crt \
  -subj "/C=US/O=Budj Test/CN=Budj Test Root CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

key inter.key
openssl req -new -key inter.key -out inter.csr \
  -subj "/C=US/O=Budj Test/CN=Budj Test Intermediate CA"
openssl x509 -req -in inter.csr -CA root.crt -CAkey root.key -CAcreateserial \
  -days 3650 -sha256 -out inter.crt \
  -extfile <(printf "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n")

key leaf.key
openssl req -new -key leaf.key -out leaf.csr -subj "/C=US/O=Budj Test/CN=Budj Test Leaf"
openssl x509 -req -in leaf.csr -CA inter.crt -CAkey inter.key -CAcreateserial \
  -days 3650 -sha256 -out leaf.crt \
  -extfile <(printf "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n")

# Impostor root using Apple's exact distinguished name.
key rogue-root.key
openssl req -x509 -new -key rogue-root.key -sha256 -days 7300 -out rogue-root.crt \
  -subj "/C=US/O=Apple Inc./OU=Apple Certification Authority/CN=Apple Root CA - G3" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

key rogue-leaf.key
openssl req -new -key rogue-leaf.key -out rogue-leaf.csr -subj "/C=US/O=Apple Inc./CN=Rogue Leaf"
openssl x509 -req -in rogue-leaf.csr -CA rogue-root.crt -CAkey rogue-root.key \
  -CAcreateserial -days 3650 -sha256 -out rogue-leaf.crt \
  -extfile <(printf "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n")
```

Then base64 the DER body of each `.crt` into `apple-jws-chain.ts` and copy the
`.key` files in verbatim.

Certificate expiry is tested by evaluating a valid chain at a date outside its
window via the `at` option, rather than by committing an expired certificate
that would change the meaning of a test run depending on the date.
