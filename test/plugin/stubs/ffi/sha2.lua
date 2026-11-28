return { sha256 = function(s)
  local name = os.tmpname(); local f = io.open(name, "wb"); f:write(s); f:close()
  local p = io.popen("sha256sum " .. name); local out = p:read("*a"); p:close(); os.remove(name)
  return out:match("^(%x+)")
end }
