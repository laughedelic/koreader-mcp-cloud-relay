local cjson = require("cjson")
local M = { null = cjson.null }
function M.encode(v) return cjson.encode(v) end
function M.decode(s) return cjson.decode(s) end
function M.array(t) return setmetatable(t or {}, { __jsontype = "array" }) end
function M.object(t) return setmetatable(t or {}, { __jsontype = "object" }) end
return M
