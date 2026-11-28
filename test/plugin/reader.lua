-- The reader's half of the plugin test (see run.sh): the plugin's own
-- modules (relay client, MCP protocol and tools, offline memory) run against
-- a local relay, with KOReader's modules replaced by the stubs in stubs/ and
-- a made-up open book. app.mjs plays the AI app; the two take turns through
-- flag files in the folder given as the first argument.
local DIR = arg[1]
local socket = require("socket")
local UIManager = require("ui/uimanager")
local NetworkMgr = require("ui/network/manager")

local function flag(name, content)
    local f = assert(io.open(DIR .. "/" .. name, "w")); f:write(content or "1"); f:close()
    print("reader: " .. name)
end
local function hasFlag(name) local f = io.open(DIR .. "/" .. name); if f then f:close(); return true end end
local function waitFor(what, done, timeout)
    if not UIManager:run(done, timeout or 40) then error("timed out waiting for " .. what) end
end

G_reader_settings = { data = {} }
function G_reader_settings:readSetting(k, d) local v = self.data[k]; if v == nil then return d end return v end
function G_reader_settings:saveSetting(k, v) self.data[k] = v end
function G_reader_settings:delSetting(k) self.data[k] = nil end
function G_reader_settings:has(k) return self.data[k] ~= nil end
function G_reader_settings:flush() end

-- A fake open book
local state = { page = 118 }
local doc = { file = "/books/secret-file-name.epub" }
function doc:getProps() return { title = "The Test Book", authors = "A. Writer", language = "en", description = "A test." } end
function doc:getPageCount() return 300 end
function doc:getToc() return {
    { title = "Chapter One", page = 1, depth = 1 }, { title = "Chapter Seven", page = 110, depth = 1 },
    { title = "Chapter Eight", page = 132, depth = 1 } } end
function doc:getPageText(p) return "Text of page " .. p .. ". The lighthouse was dark." end
local ui = { document = doc, annotation = { annotations = {
    { text = "a remarkable sentence", note = "Ask about this later", page = "/body/p[1]", pageno = 40,
      chapter = "Chapter Two", datetime = "2026-11-20 10:00:00", drawer = "lighten" },
    { text = "The lighthouse was dark", page = "/body/p[9]", pageno = 118, chapter = "Chapter Seven",
      datetime = "2026-11-27 21:00:00", drawer = "lighten" },
} } }
-- The current page comes from the reader UI: KOReader's PDF documents have
-- no getCurrentPage() of their own
function ui:getCurrentPage() return state.page end

local protocol = require("mcp_protocol"):new()
local resources = require("mcp_resources"):new()
local tools = require("mcp_tools"):new()
local prompts = require("mcp_prompts"):new()
protocol:setResources(resources); protocol:setTools(tools); protocol:setPrompts(prompts)
tools:setResources(resources); prompts:setResources(resources)
resources:setUI(ui); tools:setUI(ui); prompts:setUI(ui)

local relay = require("mcp_relay"):new()
local Memory = require("mcp_memory")
Memory.SETTLE_DELAY, Memory.PUSH_INTERVAL = 1, 16

relay:setRelayUrl(arg[2] or "http://127.0.0.1:8787")
relay:setDeviceName("Lua test reader")
relay.getManifest = function() return protocol:manifest() end
relay.onOfflineMemory = function(limits) Memory:onRegistered(limits) end
relay.onEvent = function(event) if event.event == "app_connected" then print("reader: app connected:", event.name); Memory:onAppConnected() end end
relay.onWarning = function(m) print("reader warning: " .. m) end
relay.onFatalError = function(m) error("fatal: " .. m) end
relay:setRequestHandler(function(request) return protocol:handleRequest(request) end)
Memory:setup { relay = relay, tools = tools, is_remote_mode = function() return true end }

-- Look at what is sent
local bodies = {}
local original = relay.detachedDeviceRequest
function relay:detachedDeviceRequest(method, path, body, callback, options)
    table.insert(bodies, { method = method, path = path, body = body, options = options })
    print(string.format("reader: -> %s %s (%d bytes)%s%s", method, path, body and #body or 0,
        options and options.blocking and " blocking" or "", options and options.headers and " leaving" or ""))
    return original(self, method, path, body, callback, options)
end
local function status() return Memory:getStatus() or {} end

-- 1. Connect
relay:start()
waitFor("registration", function() return relay.connected end)
assert(Memory:getLimits(), "the relay reports offline memory limits")
print("reader: registered as " .. relay.device_id .. ", limits " .. Memory:getLimits().maxBytes)
assert(not Memory:isOn(), "offline memory is off by default")
state.page = 119; Memory:markChanged()
UIManager:run(nil, 3)
assert(#bodies == 0, "nothing is sent while offline memory is off")
state.page = 118

-- 2. Turn it on: nobody is paired, so nothing is kept
Memory:setScope("pages")
waitFor("first save", function() return status().result == "no_apps" end)
assert(not bodies[1].body:find("secret%-file%-name"), "the file name is never sent")
assert(bodies[1].body:find('"number":128', 1, true) and bodies[1].body:find('"number":116', 1, true)
    and not bodies[1].body:find('"number":129', 1, true) and not bodies[1].body:find('"number":115', 1, true),
    "pages 116 to 128 are sent")
assert(bodies[1].body:find('"page":40', 1, true), "annotation pages are numbers")

-- 3. Pair an app; the copy is saved for it
local code
relay:requestPairingCode(function(ok, data) assert(ok, tostring(data)); code = data.code end)
waitFor("pairing code", function() return code end)
flag("code", relay.device_id .. " " .. code)
waitFor("saved copy", function() return status().result == "stored" end, 60)
assert(status().page == 118)
flag("stored")

-- 4. The app talks to the live reader, then the user reads on
waitFor("online check", function() return hasFlag("online_ok") end, 60)
state.page = 121; Memory:markChanged()
waitFor("save after page turn", function() return status().page == 121 end)
assert(#bodies[#bodies].body < 20000)

-- 5. The server stops (sleep): the last save waits for the relay and says the reader is leaving
UIManager:run(nil, 16)
state.page = 122; Memory:markChanged()
local before = socket.gettime()
Memory:leave()
relay:stop()
print(string.format("reader: leave took %.2fs", socket.gettime() - before))
assert(status().page == 122, "the last page was saved before sleep")
assert(bodies[#bodies].options.headers["X-Reader-Leaving"] == "1")
flag("left")

-- 6. Server off, WiFi on: reading on still updates the copy
waitFor("offline check", function() return hasFlag("offline_ok") end, 60)
UIManager:run(nil, 16)
state.page = 125; Memory:markChanged()
waitFor("background save", function() return status().page == 125 end)
flag("background")

-- 7. WiFi off: nothing is sent; when it is back, the change is saved
waitFor("background check", function() return hasFlag("background_ok") end, 60)
NetworkMgr.up = false
local sent = #bodies
state.page = 130; Memory:markChanged()
UIManager:run(nil, 4)
assert(#bodies == sent and status().page == 125 and Memory.waiting_for_network)
state.page = 131; Memory:markChanged()
assert(#UIManager.tasks == 0, "no timers while waiting for the network")
NetworkMgr.up = true
Memory:onNetworkAvailable()
waitFor("save after WiFi came back", function() return status().page == 131 end)

-- 8. Off: the copy is deleted
Memory:setScope(nil)
waitFor("deletion", function() return Memory:getStatus() == nil end)
assert(not G_reader_settings:has("mcp_memory_pending_delete"))
flag("forgotten")

-- 9. Off while offline: deletion waits for the network
Memory:setScope("position")
waitFor("save again", function() return status().result == "stored" end)
assert(not bodies[#bodies].body:find('"number"', 1, true), "no page text with scope position")
NetworkMgr.up = false
Memory:setScope(nil)
UIManager:run(nil, 1)
assert(status().result == "delete_pending" and G_reader_settings:has("mcp_memory_pending_delete"))
NetworkMgr.up = true
Memory:onNetworkAvailable()
waitFor("deferred deletion", function() return Memory:getStatus() == nil end)
flag("done")
print("reader: all reader-side checks passed")
