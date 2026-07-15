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
}
