class WindowsCredentialStore:
    service_name = "FindAnswer"

    def get(self, provider: str) -> str | None:
        import keyring

        try:
            return keyring.get_password(self.service_name, provider)
        except keyring.errors.KeyringError:
            # Headless hosts (CI, Linux) have no credential backend; a missing
            # backend cannot hold a stored key, so treat it as unconfigured.
            return None

    def set(self, provider: str, api_key: str) -> None:
        import keyring

        keyring.set_password(self.service_name, provider, api_key)
