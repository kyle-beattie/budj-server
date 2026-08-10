## ADDED Requirements

### Requirement: Native provider sign-in produces an ordinary Supabase session

The iOS app SHALL obtain an identity token from Apple or Google natively and
exchange it with Supabase directly. This server SHALL NOT proxy that exchange. A
session produced by a provider MUST be indistinguishable to this server from one
produced by email and password.

#### Scenario: Provider-issued JWT is accepted on a guarded route

- **WHEN** a request carries a valid Supabase access token originating from an
  Apple or Google sign-in
- **THEN** `requireAuth` resolves `request.auth.userId` from the verified claims
  and the request proceeds exactly as for a password-issued token

#### Scenario: The identity token never reaches this server

- **WHEN** the OpenAPI document is generated
- **THEN** it contains no route that accepts an Apple or Google identity token

### Requirement: The Apple authorization code is captured and exchanged server-side

The app SHALL send Apple's authorization code to this server at sign-in, and the
server SHALL exchange it with Apple for a refresh token. Supabase does not expose
Apple's provider tokens, and the code is single-use and expires within minutes,
so it MUST be captured at sign-in rather than retrieved later.

#### Scenario: Code is exchanged and the grant retained

- **WHEN** the app posts an Apple authorization code for the authenticated user
- **THEN** the server exchanges it with Apple and stores the resulting refresh
  token against that user

#### Scenario: The endpoint accepts a code, never an identity token

- **WHEN** the route's schema is inspected
- **THEN** it accepts an authorization code only, and no field could carry an
  identity token or a Supabase session

#### Scenario: A rejected exchange does not fail sign-in

- **WHEN** Apple refuses the code exchange
- **THEN** the failure is recorded and the user remains signed in, because the
  grant is only needed at account deletion

#### Scenario: Re-submitting for a user who already has a grant replaces it

- **WHEN** an authenticated user posts a second authorization code
- **THEN** the stored refresh token is replaced and no second row is created

### Requirement: The Apple refresh token is held under the same custody as other credentials

The stored Apple refresh token SHALL be encrypted and placed in a table with row
level security enabled and no policies, readable only by the service-role client.

#### Scenario: A user cannot read their own Apple grant

- **WHEN** a client holding a valid user JWT selects from the Apple grant table
- **THEN** zero rows are returned

#### Scenario: The stored grant is not plaintext

- **WHEN** the row is inspected directly in the database
- **THEN** the refresh token is ciphertext carrying a key-version prefix

### Requirement: Email and password remain a supported fallback

The existing credential endpoints SHALL continue to function unchanged for users
who do not sign in with a provider.

#### Scenario: Password sign-in still issues a session

- **WHEN** a registered user posts valid credentials to `/auth/sign-in`
- **THEN** a session is returned with the same shape as before this change

### Requirement: Profiles are seeded without deriving a name from an email address

The `handle_new_user` trigger SHALL read the display name from the identity
claims `full_name` then `name`, and SHALL fall back to an empty string. It MUST
NOT derive a display name from the local part of an email address.

#### Scenario: Apple private relay address does not become a display name

- **WHEN** a user signs up whose only email is
  `abc123def@privaterelay.appleid.com` and whose claims carry no name
- **THEN** the created profile has `display_name` of `''`
- **AND** the profile's `display_name` is never `abc123def`

#### Scenario: Provider-supplied name is captured on first sign-in

- **WHEN** a user signs in with Apple for the first time and the identity token
  carries `full_name`
- **THEN** the created profile stores that value as `display_name`

### Requirement: The verified JWT is the only source of a user's email

No table SHALL store a user's email address. Any response exposing an email MUST
read it from the verified token claims.

#### Scenario: Email is absent from application tables

- **WHEN** the generated database types are inspected
- **THEN** no table in `public` has an `email` column
