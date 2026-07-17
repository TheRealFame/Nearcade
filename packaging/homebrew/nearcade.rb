cask "nearcade" do
  version "3.0.3"
  sha256 "UPDATE_ME_WITH_DMG_SHA256"

  url "https://github.com/TheRealFame/Nearcade/releases/download/v#{version}/Nearcade-#{version}-universal.dmg"
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
