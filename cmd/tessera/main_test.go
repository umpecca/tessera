package main

import (
	"reflect"
	"testing"
)

func TestStringListFlagAcceptsRepeatedAndCommaSeparatedValues(t *testing.T) {
	var values stringListFlag
	if err := values.Set("127.0.0.1, 10.0.0.0/8"); err != nil {
		t.Fatalf("set comma-separated values: %v", err)
	}
	if err := values.Set("192.168.0.0/16"); err != nil {
		t.Fatalf("set repeated value: %v", err)
	}
	want := stringListFlag{"127.0.0.1", "10.0.0.0/8", "192.168.0.0/16"}
	if !reflect.DeepEqual(values, want) {
		t.Fatalf("values = %v, want %v", values, want)
	}
	if got := values.String(); got != "127.0.0.1,10.0.0.0/8,192.168.0.0/16" {
		t.Fatalf("String() = %q", got)
	}
}
