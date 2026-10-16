namespace App.Application.Features.Pricing.Services;

public sealed class PriceCalculator
{
    public decimal Apply(decimal value) => value * 2;
}
