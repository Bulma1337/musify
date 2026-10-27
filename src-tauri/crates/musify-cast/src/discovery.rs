//! Finds renderers: SSDP M-SEARCH for UPnP MediaRenderers and an mDNS query for Cast devices,
//! sent once per scan on every LAN interface. Only ephemeral UDP sockets, closed after the scan.
