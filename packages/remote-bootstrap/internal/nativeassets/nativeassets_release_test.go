//go:build cosmosh_native && linux

package nativeassets

import "testing"

func TestReleaseEmbedsBothNativeShells(t *testing.T) {
	for _, shell := range []string{"bash", "zsh"} {
		payload, err := Payload(shell)
		if err != nil || !Available(shell) || len(payload) < 20 {
			t.Fatalf("%s release module missing or invalid: %v", shell, err)
		}
	}
}
