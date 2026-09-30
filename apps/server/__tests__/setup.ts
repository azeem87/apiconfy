// A shell-level opt-out of TLS verification would mask every TLS assertion.
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
