package session

import _ "embed"

// ThirdPartyNotices keeps redistributed PTY library attribution accessible in the binary.
//
//go:embed THIRD_PARTY_NOTICES.txt
var ThirdPartyNotices string
