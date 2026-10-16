namespace App.UnitTests.Application.Features.Billing
{
    public class BillingTests
    {
        [Theory]
        public void Builds() { var builder = new App.Application.Features.Billing.InvoiceBuilder("x"); }
    }
}
