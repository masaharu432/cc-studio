package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Test

class ServerConfigTest {
    private fun ok(input: String) = ServerConfigCodec.normalizeOrigin(input) as OriginResult.Ok
    private fun errCode(input: String) = (ServerConfigCodec.normalizeOrigin(input) as OriginResult.Err).code

    @Test fun normalize_bareDomain_addsHttps() {
        assertEquals("https://workbench.tailnet.ts.net", ok("workbench.tailnet.ts.net").origin)
    }
    @Test fun normalize_stripsSchemePathQueryAndLowercasesHost() {
        assertEquals("https://host.example.ts.net", ok("https://Host.Example.TS.net/x?y#z").origin)
    }
    @Test fun normalize_keepsPort() {
        assertEquals("https://host.ts.net:8443", ok("host.ts.net:8443").origin)
    }
    @Test fun normalize_http_rejected() { assertEquals("not_https", errCode("http://host.ts.net")) }
    @Test fun normalize_ipv4_rejected() { assertEquals("is_ip", errCode("192.0.2.10")) }
    @Test fun normalize_ipv6_rejected() {
        assertEquals("is_ip", errCode("2001:db8::1"))
        assertEquals("is_ip", errCode("[2001:db8::1]:8443"))
    }
    @Test fun normalize_noDot_rejected() { assertEquals("no_dot", errCode("localhost")) }
    @Test fun normalize_empty_rejected() {
        assertEquals("empty", errCode(""))
        assertEquals("empty", errCode("   "))
    }

    // --- codec ---
    @Test fun codec_roundTrip() {
        val json = ServerConfigCodec.encode(ServerCfg("https://host.ts.net", "/home/user/projects"))
        val back = ServerConfigCodec.decode(json)
        assertEquals("https://host.ts.net", back.origin)
        assertEquals("/home/user/projects", back.defaultFolder)
    }
    @Test fun codec_decodesBlankAndBrokenAsEmpty() {
        assertEquals(null, ServerConfigCodec.decode(null).origin)
        assertEquals(null, ServerConfigCodec.decode("").origin)
        assertEquals(null, ServerConfigCodec.decode("{not json").origin)
    }
    @Test fun seed_realDomainSeeds_placeholderDoesNot() {
        assertEquals("https://workbench.tailnet.ts.net",
            ServerConfigCodec.seedOriginFrom("https://workbench.tailnet.ts.net/?folder=/x"))
        assertEquals(null, ServerConfigCodec.seedOriginFrom("https://localhost/"))
        assertEquals(null, ServerConfigCodec.seedOriginFrom(""))
    }

    // --- file store（原子的書き込み） ---
    @org.junit.Rule @JvmField val tmp = org.junit.rules.TemporaryFolder()

    @Test fun store_unsetWhenNoFile() {
        val c = ServerConfig(java.io.File(tmp.root, "server.json"))
        assertEquals(null, c.origin())
    }
    @Test fun store_setOrigin_persistsAndCleansTmp() {
        val f = java.io.File(tmp.root, "server.json")
        ServerConfig(f).setOrigin("https://host.ts.net")
        assertEquals("https://host.ts.net", ServerConfig(f).origin())
        assertEquals(false, java.io.File(tmp.root, "server.json.tmp").exists())
    }
    @Test fun store_corruptFileReadsAsUnset() {
        val f = java.io.File(tmp.root, "server.json"); f.writeText("{broken")
        assertEquals(null, ServerConfig(f).origin())
    }
    @Test fun store_setDefaultFolderBlankClears() {
        val f = java.io.File(tmp.root, "server.json")
        val c = ServerConfig(f); c.setOrigin("https://host.ts.net"); c.setDefaultFolder("   ")
        assertEquals(null, ServerConfig(f).defaultFolder())
    }
}
