namespace App.Domain.Tests.Orders;

public class OrderTests
{
    [Fact]
    public void HasTotal() => Assert.Equal(1m, new Order { Total = 1m }.Total);
}
