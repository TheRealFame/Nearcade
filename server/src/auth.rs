use std::net::SocketAddr;
use turn::auth::AuthHandler;
use turn::Error as TurnError;

pub struct StaticAuthHandler {
    username: String,
    password_key: Vec<u8>,
}

impl StaticAuthHandler {
    pub fn new(username: String, password: String) -> Self {
        let realm = "nearcade.local";
        let key = turn::auth::generate_auth_key(&username, realm, &password);
        Self {
            username,
            password_key: key,
        }
    }
}

impl AuthHandler for StaticAuthHandler {
    fn auth_handle(
        &self,
        username: &str,
        _realm: &str,
        _src_addr: SocketAddr,
    ) -> Result<Vec<u8>, TurnError> {
        if username == self.username {
            Ok(self.password_key.clone())
        } else {
            Err(TurnError::ErrFakeErr)
        }
    }
}
