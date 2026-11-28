local M = { up = true }
function M:isWifiOn() return self.up end
function M:isConnected() return self.up end
return M
