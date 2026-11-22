class WindowsCredentialStore:
    service_name = "FindAnswer"

    def get(self, provider: str) -> str | None:
        import keyring

        return keyring.get_password(self.service_name, provider)

    def set(self, provider: str, api_key: str) -> None:
        import keyring

        keyring.set_password(self.service_name, provider, api_key)
