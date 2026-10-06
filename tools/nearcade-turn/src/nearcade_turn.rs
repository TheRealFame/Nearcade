use anyhow::Result;
use clap::Parser;
use std::net::IpAddr;
use std::str::FromStr;
use std::sync::Arc;
use tokio::net::UdpSocket;
use turn::server::config::ServerConfig;
use turn::server::Server;
use webrtc_util::vnet::net::Net;
use tracing::info;

mod auth;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// The public IP address to advertise
    #[arg(long)]
    public_ip: Option<String>,

    /// The port to listen on
    #[arg(long, default_value_t = 3478)]
    port: u16,

    /// The static username for authentication
    #[arg(long)]
    username: String,

    /// The static password for authentication
    #[arg(long)]
    password: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();

    let args = Args::parse();
    
    let public_ip = if let Some(ip) = args.public_ip {
        ip
    } else {
        "127.0.0.1".to_string()
    };

    info!("Starting Nearcade Custom TURN Server on port {}", args.port);
    info!("Advertising public IP: {}", public_ip);

    let udp_socket = Arc::new(UdpSocket::bind(format!("0.0.0.0:{}", args.port)).await?);

    let auth_handler = Arc::new(auth::StaticAuthHandler::new(args.username, args.password));

    let config = ServerConfig {
        conn_configs: vec![
            turn::server::config::ConnConfig {
                conn: udp_socket,
                relay_addr_generator: Box::new(turn::relay::relay_static::RelayAddressGeneratorStatic {
                    relay_address: IpAddr::from_str(&public_ip)?,
                    address: "0.0.0.0".to_owned(),
                    net: Arc::new(Net::new(None)),
                }),
            },
        ],
        auth_handler,
        realm: "nearcade.local".to_string(),
        channel_bind_timeout: std::time::Duration::from_secs(600),
        alloc_close_notify: None,
    };

    let _server = Server::new(config).await?;
    
    info!("TURN Server running... Press Ctrl+C to stop.");
    
    tokio::signal::ctrl_c().await?;
    
    info!("Shutting down TURN Server.");
    
    Ok(())
}
