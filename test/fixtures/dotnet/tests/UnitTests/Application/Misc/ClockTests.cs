using App.Testing.Fakes;

namespace App.UnitTests.Application.Misc;

public class ClockTests
{
    [Fact]
    public void Ticks() { var clock = new FakeClock(); }
}
