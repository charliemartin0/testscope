using App.Application.Features.Pricing.Services;

namespace App.UnitTests.Application.Features.Pricing.Services;

public class PriceCalculatorTests
{
    [Fact]
    public void Doubles() => Assert.Equal(4, new PriceCalculator().Apply(2));
}
