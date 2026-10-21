cask "nearcade" do
  version "3.0.7"
  sha256 "cda65e06c1df797a0a820509e3b86b49e0cd461a127d6dfabdd066a0d5ef61bb"

  url "https://github.com/TheRealFame/Nearcade/releases/download/v3.0.7-bug-fixes/Nearcade-#{version}-universal.dmg"
  name "Nearcade"
  desc "Browser-based game streaming host — low-latency remote play"
  homepage "https://nearcade.cutefame.net"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: ">= :big_sur"

  app "Nearcade.app"

  zap trash: [
    "~/Library/Application Support/nearcade",
    "~/Library/Preferences/com.nearcade.app.plist",
    "~/Library/Saved Application State/com.nearcade.app.savedState",
  ]
end
